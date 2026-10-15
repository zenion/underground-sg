// Metric work happens in SVY21 (EPSG:3414), never in degrees: the street connector from the
// North Bridge Road exit to its nearest street vertex is about 12 m.

import { expect, test } from "vitest";
import { AT, line, NODE, seedCluster } from "./fixtures.ts";
import { SQLSTATE, useDatabase } from "./harness.ts";

const db = useDatabase(seedCluster);

test("a street connector's length, measured in SVY21, is in metres", () =>
  db.rolledBack(async () => {
    await db.query("INSERT INTO street_nodes (osm_node_id, geom) VALUES (1001, $1::geometry)", [
      `SRID=4326;POINT(${AT.northBridgeRoadVertex.join(" ")})`,
    ]);
    const connector = line(AT.northBridgeRoadExit, AT.northBridgeRoadVertex);
    await db.query(
      `INSERT INTO street_connectors (node_id, osm_node_id, length_m, geom)
       VALUES ($1, 1001, ST_Length(ST_Transform($2::geometry, 3414)), $2::geometry)`,
      [NODE.northBridgeRoadExit, connector],
    );
    expect(await db.value<number>("SELECT round(length_m)::int FROM street_connectors")).toBe(12);
  }));

test("a negative length is refused", () =>
  db.rolledBack(async () => {
    await db.query("INSERT INTO street_nodes (osm_node_id, geom) VALUES (1001, $1::geometry)", [
      `SRID=4326;POINT(${AT.northBridgeRoadVertex.join(" ")})`,
    ]);
    await db.expectRefused(
      `INSERT INTO street_connectors (node_id, osm_node_id, length_m, geom)
       VALUES ($1, 1001, -1, $2::geometry)`,
      [NODE.northBridgeRoadExit, line(AT.northBridgeRoadExit, AT.northBridgeRoadVertex)],
      { code: SQLSTATE.checkViolation, constraint: "street_connectors_length_m_check" },
    );
  }));

test("an exit has at most one street connector, keyed by its node", () =>
  db.rolledBack(async () => {
    await db.query(
      "INSERT INTO street_nodes (osm_node_id, geom) VALUES (1001, $1::geometry), (1002, $2::geometry)",
      [
        `SRID=4326;POINT(${AT.northBridgeRoadVertex.join(" ")})`,
        `SRID=4326;POINT(${AT.northBridgeRoadExit.join(" ")})`,
      ],
    );
    const connector = line(AT.northBridgeRoadExit, AT.northBridgeRoadVertex);
    await db.query(
      `INSERT INTO street_connectors (node_id, osm_node_id, length_m, geom)
       VALUES ($1, 1001, 12, $2::geometry)`,
      [NODE.northBridgeRoadExit, connector],
    );
    await db.expectRefused(
      `INSERT INTO street_connectors (node_id, osm_node_id, length_m, geom)
       VALUES ($1, 1002, 0, $2::geometry)`,
      [NODE.northBridgeRoadExit, connector],
      { code: SQLSTATE.uniqueViolation, constraint: "street_connectors_pkey" },
    );
  }));
