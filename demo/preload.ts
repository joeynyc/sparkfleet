// Demo screenshots must not show the real control host's name. The server reads it
// as `os.hostname()` on the default export (server/local-host.ts), which this replaces.
import os from "node:os";

os.hostname = () => "workstation";
