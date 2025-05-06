// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.29;

import {IEigenLayerSlasher} from "./interfaces/IEigenLayerSlasher.sol";

contract HeartbeatAVS {
    IEigenLayerSlasher public eigenlayerSlasher;

    mapping(address => uint256) public lastPing; // operator → last ping timestamp
    uint256 public interval = 30; // seconds between required pings
    uint256 public gracePeriod = 10; // grace time before slashing allowed

    mapping(address => bool) public isRegisteredOperator; // basic allowlist
    mapping(address => uint8) public penaltyCount; // operator to # of penalties

    // events
    event Pinged(address indexed operator, uint256 timestamp, string message);
    event Slashed(address indexed operator, uint256 missedAt);
    event Deregistered(address indexed operator);

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
        require(isRegisteredOperator[operator], NotAnOperator());
        uint256 last = lastPing[operator];
        require(block.timestamp > last + interval + gracePeriod, InvalidSlash(last + interval + gracePeriod));

        penaltyCount[operator] += 1;

        // mock-call to EigenLayer slashing contract
        eigenlayerSlasher.slash(operator);

        emit Slashed(operator, last);

        // deregister an operator after 3 penalties
        if (penaltyCount[operator] >= 3) {
            isRegisteredOperator[operator] = false;
            emit Deregistered(operator);
        }

        // TODO: enforce cool down to avoid multiple slashing for same missed ping
    }

    // helper functions for testing
    function registerOperator(address operator) external {
        isRegisteredOperator[operator] = true;
        penaltyCount[operator] = 0; // reset strikes on (re)registration
    }

    function getLastPing(address operator) external view returns (uint256) {
        return lastPing[operator];
    }

    function getPenaltyCount(address operator) external view returns (uint8) {
        return penaltyCount[operator];
    }
}
