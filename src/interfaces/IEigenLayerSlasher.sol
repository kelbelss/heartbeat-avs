// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.29;

interface IEigenLayerSlasher {
    function slash(address operator) external;
}
