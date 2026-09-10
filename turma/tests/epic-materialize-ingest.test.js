// SUPERSEDED — intentionally emptied (XERK-724).
//
// This file tested a HUB-SIDE consumption of XERK-723's createEpicChild /
// blocksLink primitive result caches (`ingestEpicChildResults` /
// `ingestBlocksLinkResults` in server.js). That seam was SUPERSEDED when D
// (XERK-725, #744) landed the Epic Builder's actual integration: the hub
// dispatches a `spawnEpicBuilder` command and reads back a per-agent
// `epicBuilderStatus` heartbeat field (advanced by `ingestEpicBuilderStatus`),
// and the AGENT materializes the epic. So the hub-side ingestion this file
// covered was reverted from server.js, and the correct C is an agent-side
// (hub-agent.py) implementation.
//
// The file itself is kept as an empty stub only because it could not be deleted
// in the session that made this change (file removal was tooling-blocked); it
// should be removed with `git rm` as part of the agent-side rework.

"use strict";

const test = require("node:test");

test("epic-builder hub-side result ingestion was superseded by XERK-725", { skip: true }, () => {});
