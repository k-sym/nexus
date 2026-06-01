// Task 0 — de-risk native modules on Node 26.
// Proves better-sqlite3 loads, sqlite-vec (vec0) loads, and FTS5 is compiled in.
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

function main() {
  console.log("node", process.version);

  const db = new Database(":memory:");
  console.log("better-sqlite3 OK; sqlite", db.prepare("select sqlite_version() v").get());

  sqliteVec.load(db);
  const vec = db.prepare("select vec_version() v").get() as { v: string };
  console.log("sqlite-vec loaded; vec_version", vec.v);

  // vec0 virtual table at our embedding dimensionality (nomic 768)
  db.exec("CREATE VIRTUAL TABLE t USING vec0(embedding float[768])");
  const emb = new Float32Array(768).fill(0.1);
  db.prepare("INSERT INTO t(rowid, embedding) VALUES (1, ?)").run(Buffer.from(emb.buffer));
  const knn = db
    .prepare("SELECT rowid, distance FROM t WHERE embedding MATCH ? ORDER BY distance LIMIT 1")
    .get(Buffer.from(emb.buffer));
  console.log("vec0 768-dim insert + KNN OK:", knn);

  // FTS5 compiled in?
  db.exec("CREATE VIRTUAL TABLE f USING fts5(body, tokenize='porter')");
  db.prepare("INSERT INTO f(body) VALUES ('encryption keys are rotated nightly')").run();
  const hit = db.prepare("SELECT rowid FROM f WHERE f MATCH 'encrypt*'").get();
  console.log("FTS5 porter + prefix OK:", hit);

  db.close();
  console.log("\nALL NATIVE CHECKS PASSED ✅");
}

main();
