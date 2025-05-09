# 💓 Heartbeat AVS 

**Heartbeat AVS** is a simple proof-of-liveness system for restaked operators using [EigenLayer](https://www.eigenlayer.xyz/) as the security layer. Operators must regularly call a `ping()` function to prove they are online and active. If they fail to ping within a specified interval, they can be slashed.

This project combines smart contracts, off-chain agents, and AI-powered messaging to simulate a minimal AVS. It’s designed as a learning project for exploring how to build and test restaking-based infrastructure using tools like EigenLayer and GPT-based agents.


## Features

| Feature                      | Description                                                       |
| ---------------------------- | ----------------------------------------------------------------- |
| `ping()` liveness mechanism  | Operators prove uptime by calling `ping()` every 30 seconds       |
| Slashing logic               | Anyone can slash if a ping is missed (with a grace period)        |
| AI-generated status messages | Off-chain bot generates natural language messages using GPT       |
| Telegram alert bot           | Notifies when an operator is slashed, using human-readable alerts |
| `/status` command (Telegram) | Users can query current operator status                           |
| Built for EigenLayer         | Designed to align with EigenLayer’s restaking and slashing model  |
---


## Project Goal

This project simulates the core components of an AVS on EigenLayer:

- Operators must maintain consistent liveness
- Slashing incentivises honest behaviour
- Observability is enhanced via off-chain bots and alerts

It serves as a hands-on introduction to AVS design, restaking logic, and integrating AI with onchain/offchain infrastructure.


## 👤 Actors

| Role        | Responsibility                                                     |
| ----------- | ------------------------------------------------------------------ |
| AVS Creator | Deploys contracts and defines slashing parameters                  |
| Operator    | Regularly calls `ping()` to prove they are live and restaked       |
| Slasher     | Monitors missed pings and triggers `slash()` when conditions apply |
| EigenLayer  | Provides restaking infrastructure and underlying slashing logic    |
---


## Off-Chain Agent (Operator Ping Bot)

- Runs every 30 seconds
- Calls `ping()` with an LLM-generated message
- Written in TypeScript, runs on Node.js


## Telegram Alert Bot (Slasher Agent)

Monitors for missed pings and alerts users via Telegram using the Bot API and GPT for explanations.

Example alert:

> ❌ Operator 0x123 was slashed. Missed ping for 43s (grace: 10s). Last seen at block 198,512.
> 

The bot can also support `/status` commands for querying operator state.


## Local Testing (Mock Registry)

To simulate EigenLayer at a very basic level in development, a simple mock registry is used:

`mapping(address => bool) public isRegisteredOperator;`


## Purpose of Project

This project is purely for learning purposes. I’m excited to continue building on top of this, especially fully integrating EigenLayer modules and essential AVS logic.