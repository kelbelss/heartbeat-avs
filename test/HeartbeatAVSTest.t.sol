// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.29;

import {Test, console} from "forge-std/Test.sol";
import {HeartbeatAVS} from "../src/HeartbeatAVS.sol";
import {MockEigenSlasher} from "../src/mocks/MockEigenSlasher.sol";

contract HeartbeatAVSTest is Test {
    HeartbeatAVS internal avs;
    MockEigenSlasher internal slasher;

    address operator = makeAddr("operator");
    address nonOperator = makeAddr("nonOperator");
    uint256 interval = 30;
    uint256 grace = 10;

    function setUp() public {
        slasher = new MockEigenSlasher();
        avs = new HeartbeatAVS(address(slasher));

        // reigister an operator
        vm.prank(address(this));
        avs.registerOperator(operator);
    }

    function testPingSuccess() public {
        vm.prank(operator);
        avs.ping("System nominal");

        assertEq(avs.lastPing(operator), block.timestamp);
        console.log("Pinged operator:", operator);
        console.log("Pinged timestamp:", block.timestamp);
    }

    function testPingRevertsIfNotRegistered() public {
        vm.expectRevert(HeartbeatAVS.NotAnOperator.selector);
        vm.prank(nonOperator);
        avs.ping("Trying to ping");
        console.log("Pinged non-operator:", nonOperator);
    }

    function testCannotSlashBeforeGracePeriod() public {
        vm.prank(operator);
        avs.ping("OK");

        uint256 expected = block.timestamp + interval + grace;

        // warp just before slash window
        vm.warp(expected - 1);

        vm.expectRevert(abi.encodeWithSelector(HeartbeatAVS.InvalidSlash.selector, expected));
        avs.slash(operator);
    }

    function testCanSlashAfterGracePeriod() public {
        vm.prank(operator);
        avs.ping("Initial");

        vm.warp(block.timestamp + interval + grace + 1);

        avs.slash(operator);
    }

    function testEventsEmit() public {
        vm.prank(operator);
        vm.expectEmit(true, true, false, true);
        emit HeartbeatAVS.Pinged(operator, block.timestamp, "Check");
        avs.ping("Check");

        vm.warp(block.timestamp + interval + grace + 1);

        vm.expectEmit(true, true, false, true);
        emit HeartbeatAVS.Slashed(operator, block.timestamp - (interval + grace + 1));
        avs.slash(operator);
    }
}
