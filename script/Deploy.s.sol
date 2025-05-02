// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.29;

import "forge-std/Script.sol";
import {HeartbeatAVS} from "../src/HeartbeatAVS.sol";
import {MockEigenSlasher} from "../src/mocks/MockEigenSlasher.sol";

contract DeployHeartbeatAVS is Script {
    function run() external {
        vm.startBroadcast();

        MockEigenSlasher slasher = new MockEigenSlasher();
        HeartbeatAVS avs = new HeartbeatAVS(address(slasher));

        console.log("HeartbeatAVS deployed to:", address(avs));
        console.log("MockEigenSlasher deployed to:", address(slasher));

        vm.stopBroadcast();
    }
}
