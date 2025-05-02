// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.29;

import "../interfaces/IEigenLayerSlasher.sol";

contract MockEigenSlasher is IEigenLayerSlasher {
    event MockSlashed(address operator);

    function slash(address operator) external override {
        // emit an event to simulate slashing
        emit MockSlashed(operator);
    }
}
