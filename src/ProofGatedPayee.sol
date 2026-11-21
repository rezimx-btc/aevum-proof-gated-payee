// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @title ProofGatedPayee — confirmation-of-payee escrow for tUSD8 on Aevum
/// @author rezimx-btc
/// @notice A payer locks tUSD8 into escrow against an invoice. Funds only move
///         to the payee when an authorized verification agent calls release()
///         after the on-chain gate passes: payee is registered in the allowlist,
///         the invoice is still active and unexpired, and the release fits inside
///         the agent's spending limit for the current window. Every step emits an
///         event, so the full audit trail is visible on the explorer.
/// @dev Written fresh from DESIGN.md (Aevum Builder Challenge #1, track
///      Confirmation of Payee). No owner backdoor over escrowed funds: the owner
///      can only manage the payee registry, agent authorization and spending
///      limits. A payer can always get funds back via refund() once the invoice
///      has expired, the payee has been revoked, or the invoice was cancelled.
///      Checks-Effects-Interactions ordering is used throughout.
contract ProofGatedPayee {
    // ------------------------------------------------------------------ Types

    enum Status {
        Created,
        Released,
        Refunded,
        Cancelled
    }

    struct Payee {
        string name;
        bool registered;
    }

    struct Invoice {
        address payer;
        address payee;
        uint256 amount;
        bytes32 purposeHash;
        uint64 expiry;
        Status status;
    }

    struct SpendLimit {
        uint256 cap; // max tUSD8 (base units, 6 decimals) the agent may release per window
        uint256 windowSeconds; // length of one window; 0 means the window never resets
        uint256 spent; // tUSD8 released by the agent inside the current window
        uint64 windowStart; // start of the current window
    }

    // ------------------------------------------------------------------ State

    /// @notice The tUSD8 token held in escrow (6 decimals on Aevum testnet).
    address public immutable token;

    /// @notice Deployer. Manages the registry, agents and spending limits only.
    address public immutable owner;

    /// @notice Next invoice id to assign (starts at 0).
    uint256 public nextInvoiceId;

    /// @notice invoiceId => invoice.
    mapping(uint256 => Invoice) public invoices;

    /// @notice payee address => registry entry.
    mapping(address => Payee) public payees;

    /// @notice Session keys: addresses allowed to call release().
    mapping(address => bool) public authorizedAgents;

    /// @notice agent => spending limit for the current window.
    mapping(address => SpendLimit) public spendLimits;

    // ------------------------------------------------------------------ Events

    event InvoiceCreated(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        uint256 amount,
        bytes32 purposeHash,
        uint64 expiry
    );
    event PayeeRegistered(string name, address indexed payee);
    event PayeeRevoked(address indexed payee);
    event AgentAuthorized(address indexed agent, bool authorized);
    event SpendingLimitSet(address indexed agent, uint256 cap, uint256 windowSeconds);
    event PayeeVerified(uint256 indexed id, address indexed payee, address indexed agent);
    event Released(uint256 indexed id, address indexed payee, uint256 amount, address indexed agent);
    event Refunded(uint256 indexed id, address indexed payer, uint256 amount);
    event InvoiceCancelled(uint256 indexed id, address indexed payer);

    // ------------------------------------------------------------------ Errors

    error NotOwner();
    error NotPayer();
    error NotAuthorizedAgent();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidExpiry();
    error PayeeNotRegistered();
    error InvoiceNotFound();
    error InvoiceNotActive();
    error InvoiceExpired();
    error InvoiceNotExpired();
    error SpendingLimitExceeded();
    error TransferFailed();

    // -------------------------------------------------------------- Modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ------------------------------------------------------------ Constructor

    constructor(address _token) {
        if (_token == address(0)) revert ZeroAddress();
        token = _token;
        owner = msg.sender;
    }

    // ------------------------------------------------------- Registry (owner)

    /// @notice Add (or re-add) a payee to the allowlist with a human-readable name.
    function registerPayee(string calldata name, address payee) external onlyOwner {
        if (payee == address(0)) revert ZeroAddress();
        payees[payee] = Payee({name: name, registered: true});
        emit PayeeRegistered(name, payee);
    }

    /// @notice Remove a payee from the allowlist. Existing invoices to this
    ///         payee can no longer be released, and become refundable.
    function revokePayee(address payee) external onlyOwner {
        payees[payee].registered = false;
        emit PayeeRevoked(payee);
    }

    /// @notice Grant or revoke a session key (an agent allowed to call release()).
    /// @dev A session key can ONLY release verified invoices — it can never
    ///      withdraw escrowed funds to an arbitrary address.
    function authorizeAgent(address agent, bool authorized) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        authorizedAgents[agent] = authorized;
        emit AgentAuthorized(agent, authorized);
    }

    /// @notice Set (or reset) an agent's spending limit. Resets the spent
    ///         counter and starts a fresh window.
    /// @dev Set cap to type(uint256).max for "no effective limit".
    function setSpendingLimit(address agent, uint256 cap, uint256 windowSeconds) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        SpendLimit storage limit = spendLimits[agent];
        limit.cap = cap;
        limit.windowSeconds = windowSeconds;
        limit.spent = 0;
        limit.windowStart = uint64(block.timestamp);
        emit SpendingLimitSet(agent, cap, windowSeconds);
    }

    // ------------------------------------------------------------ Invoices

    /// @notice Lock `amount` tUSD8 into escrow against a new invoice.
    /// @dev The payee does NOT need to be registered yet — registration is
    ///      checked at release time, so an invoice to an unknown payee simply
    ///      cannot be released (the demo's failure case) and stays refundable.
    ///      Caller must have approved this contract for at least `amount`.
    function createInvoice(address payee, uint256 amount, bytes32 purposeHash, uint64 expiry)
        external
        returns (uint256 id)
    {
        if (payee == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (expiry <= block.timestamp) revert InvalidExpiry();

        id = nextInvoiceId++;
        invoices[id] = Invoice({
            payer: msg.sender,
            payee: payee,
            amount: amount,
            purposeHash: purposeHash,
            expiry: expiry,
            status: Status.Created
        });

        bool ok = IERC20(token).transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        emit InvoiceCreated(id, msg.sender, payee, amount, purposeHash, expiry);
    }

    /// @notice Read the full invoice struct (the public mapping getter only
    ///         returns the fields one by one).
    function getInvoice(uint256 id) external view returns (Invoice memory) {
        return invoices[id];
    }

    /// @notice The payer cancels an invoice that has not been released yet.
    ///         Funds stay in escrow until refund() is called.
    function cancelInvoice(uint256 id) external {
        Invoice storage inv = invoices[id];
        if (inv.payer == address(0)) revert InvoiceNotFound();
        if (msg.sender != inv.payer) revert NotPayer();
        if (inv.status != Status.Created) revert InvoiceNotActive();

        inv.status = Status.Cancelled;
        emit InvoiceCancelled(id, msg.sender);
    }

    /// @notice The payer takes escrowed funds back. Allowed only when the
    ///         invoice is cancelled, or when it has expired, or when its payee
    ///         is no longer registered. Never allowed for a released invoice.
    function refund(uint256 id) external {
        Invoice storage inv = invoices[id];
        if (inv.payer == address(0)) revert InvoiceNotFound();
        if (msg.sender != inv.payer) revert NotPayer();

        if (inv.status == Status.Cancelled) {
            // Cancelled invoices are always refundable.
        } else {
            if (inv.status != Status.Created) revert InvoiceNotActive();
            bool expired = block.timestamp > inv.expiry;
            bool revoked = !payees[inv.payee].registered;
            if (!expired && !revoked) revert InvoiceNotExpired();
        }

        inv.status = Status.Refunded;
        bool ok = IERC20(token).transfer(inv.payer, inv.amount);
        if (!ok) revert TransferFailed();

        emit Refunded(id, inv.payer, inv.amount);
    }

    // ------------------------------------------------------- Verification gate

    /// @notice Off-chain agents (and the UI) call this before attempting a
    ///         release: it reports every gate condition for `agent` on `id`.
    /// @return payeeRegistered whether the payee is currently on the allowlist
    /// @return notExpired whether the invoice has not passed its expiry
    /// @return agentAuthorized whether `agent` holds a live session key
    /// @return withinSpendLimit whether the release fits the agent's remaining cap
    /// @return active whether the invoice is still in Created status
    function verifyPayee(uint256 id, address agent)
        external
        view
        returns (
            bool payeeRegistered,
            bool notExpired,
            bool agentAuthorized,
            bool withinSpendLimit,
            bool active
        )
    {
        return _verifyPayee(id, agent);
    }

    /// @notice Convenience view: true only when every gate condition passes.
    function canRelease(uint256 id, address agent) external view returns (bool) {
        (bool registered, bool notExpired, bool authorized, bool withinLimit, bool active) =
            _verifyPayee(id, agent);
        return registered && notExpired && authorized && withinLimit && active;
    }

    /// @notice Remaining tUSD8 the agent may still release in its current window.
    function remainingSpend(address agent) external view returns (uint256) {
        SpendLimit storage limit = spendLimits[agent];
        if (limit.cap == type(uint256).max) return type(uint256).max;
        if (limit.windowSeconds > 0 && block.timestamp >= limit.windowStart + limit.windowSeconds) {
            return limit.cap; // window has elapsed: a fresh window starts on next release
        }
        if (limit.spent >= limit.cap) return 0;
        return limit.cap - limit.spent;
    }

    // ------------------------------------------------------------- Release

    /// @notice The verification agent releases escrowed tUSD8 to the payee.
    ///         Reverts unless EVERY gate condition passes:
    ///         caller is an authorized session key, invoice is active and
    ///         unexpired, payee is registered, and the amount fits the agent's
    ///         remaining spending limit for the current window.
    function release(uint256 id) external {
        if (!authorizedAgents[msg.sender]) revert NotAuthorizedAgent();

        Invoice storage inv = invoices[id];
        if (inv.payer == address(0)) revert InvoiceNotFound();
        if (inv.status != Status.Created) revert InvoiceNotActive();
        if (block.timestamp > inv.expiry) revert InvoiceExpired();
        if (!payees[inv.payee].registered) revert PayeeNotRegistered();

        // Spending limit: roll the window forward when it has elapsed.
        SpendLimit storage limit = spendLimits[msg.sender];
        if (limit.windowSeconds > 0 && block.timestamp >= limit.windowStart + limit.windowSeconds) {
            limit.spent = 0;
            limit.windowStart = uint64(block.timestamp);
        }
        if (!_withinSpendLimit(msg.sender, inv.amount)) revert SpendingLimitExceeded();
        limit.spent += inv.amount;

        inv.status = Status.Released;

        emit PayeeVerified(id, inv.payee, msg.sender);

        bool ok = IERC20(token).transfer(inv.payee, inv.amount);
        if (!ok) revert TransferFailed();

        emit Released(id, inv.payee, inv.amount, msg.sender);
    }

    // -------------------------------------------------------------- Internal

    function _verifyPayee(uint256 id, address agent)
        internal
        view
        returns (
            bool payeeRegistered,
            bool notExpired,
            bool agentAuthorized,
            bool withinSpendLimit,
            bool active
        )
    {
        Invoice storage inv = invoices[id];
        payeeRegistered = payees[inv.payee].registered;
        notExpired = block.timestamp <= inv.expiry;
        agentAuthorized = authorizedAgents[agent];
        withinSpendLimit = _withinSpendLimit(agent, inv.amount);
        active = inv.status == Status.Created;
    }

    /// @dev True when `amount` fits the agent's remaining cap. A cap of
    ///      type(uint256).max means "no effective limit".
    function _withinSpendLimit(address agent, uint256 amount) internal view returns (bool) {
        SpendLimit storage limit = spendLimits[agent];
        if (limit.cap == type(uint256).max) return true;
        uint256 spent = limit.spent;
        if (limit.windowSeconds > 0 && block.timestamp >= limit.windowStart + limit.windowSeconds) {
            spent = 0; // window has elapsed
        }
        return spent + amount <= limit.cap;
    }
}
