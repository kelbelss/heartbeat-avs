// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.29;

import "forge-std/Script.sol";
import {HeartbeatAVS} from "../src/HeartbeatAVS.sol";
import {MockEigenSlasher} from "../src/mocks/MockEigenSlasher.sol";

contract DeployHeartbeatAVS is Script {
    function run() external returns (HeartbeatAVS, MockEigenSlasher) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address operatorToRegister = vm.envAddress("OPERATOR_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        MockEigenSlasher slasher = new MockEigenSlasher();
        console.log("MockEigenSlasher deployed to:", address(slasher));

        HeartbeatAVS avs = new HeartbeatAVS(address(slasher));
        console.log("HeartbeatAVS deployed to:", address(avs));

        console.log("Registering Operator:", operatorToRegister);
        avs.registerOperator(operatorToRegister);

        vm.stopBroadcast();
        return (avs, slasher);
    }
}
