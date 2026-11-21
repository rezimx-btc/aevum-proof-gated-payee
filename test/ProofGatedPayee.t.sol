// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProofGatedPayee} from "../src/ProofGatedPayee.sol";

/// @notice Minimal mintable ERC-20 with 6 decimals, standing in for tUSD8.
contract MockTUSD8 {
    string public name = "tUSD8";
    string public symbol = "tUSD8";
    uint8 public decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

contract ProofGatedPayeeTest is Test {
    ProofGatedPayee internal pgp;
    MockTUSD8 internal token;

    address internal payer = address(0x1001);
    address internal agent = address(0x2002);
    address internal payee = address(0x3003);
    address internal stranger = address(0x4004);

    uint256 internal constant DAY = 1 days;
    bytes32 internal constant PURPOSE = keccak256("invoice: kopi 5 tUSD8");

    function setUp() public {
        token = new MockTUSD8();
        pgp = new ProofGatedPayee(address(token));

        // Owner (this test contract) sets up the demo world:
        // "Vendor Kopi" is registered, `agent` holds a session key with a
        // 100 tUSD8 cap per day, and the payer is funded with 10_000 tUSD8.
        pgp.registerPayee("Vendor Kopi", payee);
        pgp.authorizeAgent(agent, true);
        pgp.setSpendingLimit(agent, 100e6, DAY);
        token.mint(payer, 10_000e6);
    }

    // -------------------------------------------------------------- Helpers

    function _createInvoice(uint256 amount, address to, uint64 expiry) internal returns (uint256 id) {
        vm.startPrank(payer);
        token.approve(address(pgp), amount);
        id = pgp.createInvoice(to, amount, PURPOSE, expiry);
        vm.stopPrank();
    }

    function _createInvoice5() internal returns (uint256 id) {
        return _createInvoice(5e6, payee, uint64(block.timestamp + 7 days));
    }

    // ------------------------------------------------------- Happy path

    function testCreateInvoiceLocksFunds() public {
        uint256 id = _createInvoice5();
        assertEq(token.balanceOf(address(pgp)), 5e6, "escrow holds 5 tUSD8");
        assertEq(token.balanceOf(payer), 10_000e6 - 5e6, "payer debited");

        ProofGatedPayee.Invoice memory inv = pgp.getInvoice(id);
        assertEq(inv.payer, payer);
        assertEq(inv.payee, payee);
        assertEq(inv.amount, 5e6);
        assertEq(inv.purposeHash, PURPOSE);
        assertEq(uint8(inv.status), uint8(ProofGatedPayee.Status.Created));
    }

    function testReleaseSuccess() public {
        uint256 id = _createInvoice5();

        vm.prank(agent);
        pgp.release(id);

        assertEq(token.balanceOf(payee), 5e6, "payee received 5 tUSD8");
        assertEq(token.balanceOf(address(pgp)), 0, "escrow empty");
        assertEq(uint8(pgp.getInvoice(id).status), uint8(ProofGatedPayee.Status.Released));
        assertEq(pgp.remainingSpend(agent), 95e6, "spend cap reduced by 5");
    }

    function testVerifyPayeeView() public {
        uint256 id = _createInvoice5();

        (bool registered, bool notExpired, bool authorized, bool withinLimit, bool active) =
            pgp.verifyPayee(id, agent);
        assertTrue(registered, "payee registered");
        assertTrue(notExpired, "not expired");
        assertTrue(authorized, "agent authorized");
        assertTrue(withinLimit, "within spend limit");
        assertTrue(active, "invoice active");
        assertTrue(pgp.canRelease(id, agent), "canRelease true");

        // After release the gate closes (invoice no longer active).
        vm.prank(agent);
        pgp.release(id);
        assertFalse(pgp.canRelease(id, agent), "canRelease false after release");
    }

    // ------------------------------------------------------- Failure paths

    function testReleaseUnregisteredPayeeReverts() public {
        // Demo failure case: invoice to an address that was never registered.
        uint256 id = _createInvoice(5e6, stranger, uint64(block.timestamp + 7 days));

        (bool registered,,,,) = pgp.verifyPayee(id, agent);
        assertFalse(registered, "stranger not registered");
        assertFalse(pgp.canRelease(id, agent), "gate closed");

        vm.prank(agent);
        vm.expectRevert(ProofGatedPayee.PayeeNotRegistered.selector);
        pgp.release(id);

        // Funds are safe in escrow, not lost.
        assertEq(token.balanceOf(address(pgp)), 5e6);
    }

    function testReleaseByUnauthorizedAgentReverts() public {
        uint256 id = _createInvoice5();

        vm.prank(stranger);
        vm.expectRevert(ProofGatedPayee.NotAuthorizedAgent.selector);
        pgp.release(id);
    }

    function testReleaseAfterAgentRevokedReverts() public {
        uint256 id = _createInvoice5();
        pgp.authorizeAgent(agent, false);

        vm.prank(agent);
        vm.expectRevert(ProofGatedPayee.NotAuthorizedAgent.selector);
        pgp.release(id);
    }

    function testReleaseExpiredInvoiceReverts() public {
        uint256 id = _createInvoice5();
        vm.warp(vm.getBlockTimestamp() + 8 days); // past the 7-day expiry

        vm.prank(agent);
        vm.expectRevert(ProofGatedPayee.InvoiceExpired.selector);
        pgp.release(id);
    }

    function testDoubleReleaseReverts() public {
        uint256 id = _createInvoice5();
        vm.prank(agent);
        pgp.release(id);

        vm.prank(agent);
        vm.expectRevert(ProofGatedPayee.InvoiceNotActive.selector);
        pgp.release(id);
    }

    function testReleaseUnknownInvoiceReverts() public {
        vm.prank(agent);
        vm.expectRevert(ProofGatedPayee.InvoiceNotFound.selector);
        pgp.release(999);
    }

    // ------------------------------------------------------- Refunds

    function testRefundAfterExpiry() public {
        uint256 id = _createInvoice5();
        vm.warp(vm.getBlockTimestamp() + 8 days);

        vm.prank(payer);
        pgp.refund(id);

        assertEq(token.balanceOf(payer), 10_000e6, "payer fully refunded");
        assertEq(uint8(pgp.getInvoice(id).status), uint8(ProofGatedPayee.Status.Refunded));
    }

    function testRefundRevokedPayee() public {
        uint256 id = _createInvoice5();
        pgp.revokePayee(payee); // payee loses registration before expiry

        vm.prank(payer);
        pgp.refund(id);

        assertEq(token.balanceOf(payer), 10_000e6, "payer fully refunded");
    }

    function testRefundBeforeExpiryReverts() public {
        uint256 id = _createInvoice5(); // still active, payee still registered

        vm.prank(payer);
        vm.expectRevert(ProofGatedPayee.InvoiceNotExpired.selector);
        pgp.refund(id);
    }

    function testCancelThenRefund() public {
        uint256 id = _createInvoice5();

        vm.prank(payer);
        pgp.cancelInvoice(id);
        assertEq(uint8(pgp.getInvoice(id).status), uint8(ProofGatedPayee.Status.Cancelled));

        // A cancelled invoice can no longer be released...
        vm.prank(agent);
        vm.expectRevert(ProofGatedPayee.InvoiceNotActive.selector);
        pgp.release(id);

        // ...but the payer can always take the funds back.
        vm.prank(payer);
        pgp.refund(id);
        assertEq(token.balanceOf(payer), 10_000e6);
    }

    function testRefundOnlyByPayer() public {
        uint256 id = _createInvoice5();
        vm.warp(vm.getBlockTimestamp() + 8 days);

        vm.prank(stranger);
        vm.expectRevert(ProofGatedPayee.NotPayer.selector);
        pgp.refund(id);
    }

    function testDemoFailureCaseEndToEnd() public {
        // The demo's failure case, start to finish: invoice to an unknown
        // payee -> agent refuses -> payer gets everything back after expiry.
        uint256 id = _createInvoice(5e6, stranger, uint64(block.timestamp + 7 days));

        vm.prank(agent);
        vm.expectRevert(ProofGatedPayee.PayeeNotRegistered.selector);
        pgp.release(id);

        vm.warp(vm.getBlockTimestamp() + 8 days);
        vm.prank(payer);
        pgp.refund(id);

        assertEq(token.balanceOf(payer), 10_000e6);
        assertEq(token.balanceOf(address(pgp)), 0);
        assertEq(token.balanceOf(stranger), 0, "unknown payee got nothing");
    }

    // ------------------------------------------------------- Spending limits

    function testSpendingLimitEnforced() public {
        // Agent cap is 100 tUSD8/day. Two 60 tUSD8 releases exceed it.
        uint256 id1 = _createInvoice(60e6, payee, uint64(block.timestamp + 7 days));
        uint256 id2 = _createInvoice(60e6, payee, uint64(block.timestamp + 7 days));

        vm.prank(agent);
        pgp.release(id1);
        assertEq(pgp.remainingSpend(agent), 40e6);

        vm.prank(agent);
        vm.expectRevert(ProofGatedPayee.SpendingLimitExceeded.selector);
        pgp.release(id2);
    }

    function testSpendingWindowResets() public {
        uint256 id1 = _createInvoice(100e6, payee, uint64(block.timestamp + 7 days));
        vm.prank(agent);
        pgp.release(id1);
        assertEq(pgp.remainingSpend(agent), 0, "cap fully used");

        // One day later the window rolls over and the cap is fresh.
        vm.warp(vm.getBlockTimestamp() + DAY + 1);
        assertEq(pgp.remainingSpend(agent), 100e6, "fresh window");

        uint256 id2 = _createInvoice(100e6, payee, uint64(block.timestamp + 7 days));
        vm.prank(agent);
        pgp.release(id2);
        assertEq(token.balanceOf(payee), 200e6);
    }

    function testUnlimitedCap() public {
        pgp.setSpendingLimit(agent, type(uint256).max, DAY);
        uint256 id = _createInvoice(9_000e6, payee, uint64(block.timestamp + 7 days));
        vm.prank(agent);
        pgp.release(id);
        assertEq(token.balanceOf(payee), 9_000e6);
    }

    function testAgentWithoutLimitCannotRelease() public {
        // A newly authorized agent with no spending limit set has cap 0:
        // least-privilege default — release is blocked until the owner sets a cap.
        address agent2 = address(0x5005);
        pgp.authorizeAgent(agent2, true);
        uint256 id = _createInvoice5();

        vm.prank(agent2);
        vm.expectRevert(ProofGatedPayee.SpendingLimitExceeded.selector);
        pgp.release(id);
    }

    // ------------------------------------------------------- Owner controls

    function testOnlyOwnerFunctions() public {
        vm.startPrank(stranger);
        vm.expectRevert(ProofGatedPayee.NotOwner.selector);
        pgp.registerPayee("Evil", stranger);
        vm.expectRevert(ProofGatedPayee.NotOwner.selector);
        pgp.authorizeAgent(stranger, true);
        vm.expectRevert(ProofGatedPayee.NotOwner.selector);
        pgp.setSpendingLimit(stranger, 1, 1);
        vm.stopPrank();
    }

    // ------------------------------------------------------- Validation

    function testCreateInvoiceValidation() public {
        vm.startPrank(payer);
        token.approve(address(pgp), type(uint256).max);

        vm.expectRevert(ProofGatedPayee.ZeroAddress.selector);
        pgp.createInvoice(address(0), 1e6, PURPOSE, uint64(block.timestamp + 1 days));

        vm.expectRevert(ProofGatedPayee.ZeroAmount.selector);
        pgp.createInvoice(payee, 0, PURPOSE, uint64(block.timestamp + 1 days));

        vm.expectRevert(ProofGatedPayee.InvalidExpiry.selector);
        pgp.createInvoice(payee, 1e6, PURPOSE, uint64(block.timestamp)); // expiry == now

        vm.stopPrank();
    }

    function testCreateInvoiceWithoutApprovalReverts() public {
        // No approve() call: transferFrom must fail.
        vm.prank(payer);
        vm.expectRevert("allowance");
        pgp.createInvoice(payee, 1e6, PURPOSE, uint64(block.timestamp + 1 days));
    }

    function testRegisterPayeeZeroAddressReverts() public {
        vm.expectRevert(ProofGatedPayee.ZeroAddress.selector);
        pgp.registerPayee("Nobody", address(0));
    }
}
