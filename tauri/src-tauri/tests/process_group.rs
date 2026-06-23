// Verifies a spawned child started in its own process group can be group-killed
// along with a grandchild it spawned — the property node-pty terminals rely on.
use nexus_tauri_lib::supervisor::{spawn_node, Child};
use std::io::Write;
use std::time::Duration;

#[test]
fn group_kill_reaps_grandchild() {
    // Parent node script spawns a long-lived child node, writes both PIDs to a file.
    let dir = std::env::temp_dir().join("nexus_pg_test");
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("parent.js");
    let pidfile = dir.join("pids.txt");
    let _ = std::fs::remove_file(&pidfile);
    let mut f = std::fs::File::create(&script).unwrap();
    write!(f, r#"
const {{ spawn }} = require('child_process');
const fs = require('fs');
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{{}},1e9)'], {{ stdio: 'ignore' }});
fs.writeFileSync({:?}, process.pid + "\n" + child.pid + "\n");
setInterval(()=>{{}}, 1e9);
"#, pidfile.to_str().unwrap()).unwrap();

    let node = nexus_tauri_lib::node::resolve_node().expect("node >= 20 required for this test");
    let child: Child = spawn_node(&node, &script, &dir).unwrap();
    // Wait for pidfile.
    let mut tries = 0;
    while !pidfile.exists() && tries < 50 { std::thread::sleep(Duration::from_millis(100)); tries += 1; }
    let pids = std::fs::read_to_string(&pidfile).unwrap();
    let grandchild: i32 = pids.lines().nth(1).unwrap().trim().parse().unwrap();

    child.kill_group();
    std::thread::sleep(Duration::from_millis(500));
    // kill -0 returns Err once the grandchild is gone.
    let alive = unsafe { libc::kill(grandchild, 0) } == 0;
    assert!(!alive, "grandchild {grandchild} should be dead after group kill");
}
