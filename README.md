# 💓 Heartbeat AVS 

**Heartbeat AVS** is a simple proof-of-liveness system for restaked operators using [EigenLayer](https://www.eigenlayer.xyz/) as the security layer. Operators must regularly call a `ping()` function to prove they are online and active. If they fail to ping within a specified interval, they can be slashed.

This project combines smart contracts, off-chain agents, and AI-powered messaging to simulate a minimal AVS. It’s designed as a learning project for exploring how to build and test restaking-based infrastructure using tools like EigenLayer and GPT-based agents.