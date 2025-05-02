// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.29;

import {IEigenLayerSlasher} from "./interfaces/IEigenLayerSlasher.sol";

contract HeartbeatAVS {
    IEigenLayerSlasher public eigenlayerSlasher;

    mapping(address => uint256) public lastPing; // operator → last ping timestamp
    uint256 public interval = 30; // seconds between required pings
    uint256 public gracePeriod = 10; // grace time before slashing allowed

    mapping(address => bool) public isRegisteredOperator; // basic allowlist

    // events
    event Pinged(address indexed operator, uint256 timestamp, string message);
    event Slashed(address indexed operator, uint256 missedAt);

    // errors
    error NotAnOperator();
    error InvalidSlash(uint256 expected);

    constructor(address slasher) {
        eigenlayerSlasher = IEigenLayerSlasher(slasher);
    }

    function ping(string memory statusMessage) external {
        require(isRegisteredOperator[msg.sender], NotAnOperator());
        lastPing[msg.sender] = block.timestamp;
        emit Pinged(msg.sender, block.timestamp, statusMessage);
    }

    function slash(address operator) external {
        uint256 last = lastPing[operator];
        require(block.timestamp > last + interval + gracePeriod, InvalidSlash(last + interval + gracePeriod));

        // Pseudo-call to EigenLayer slashing hook
        eigenlayerSlasher.slash(operator);
        emit Slashed(operator, last);
    }

    // helper functions for testing
    function registerOperator(address operator) external {
        isRegisteredOperator[operator] = true;
    }
}
