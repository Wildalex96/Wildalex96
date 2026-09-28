# LocalMind Windows isolated code runner

This directory defines a Windows Sandbox based execution boundary for untrusted agent code.

## Security model
- The agent never receives the user's real filesystem path.
- A per-job staging directory is copied into the sandbox as `C:\work`.
- The sandbox has networking disabled by default.
- The sandbox is disposable: it is destroyed after every job.
- Only stdout/stderr and explicitly exported files are copied back.
- The host only launches the sandbox with a generated `.wsb` file and a temporary payload.

Windows Sandbox must be enabled in Windows Features. The host application should verify that `WindowsSandbox.exe` exists before offering code execution.

## Important limitation
Windows Sandbox is a disposable lightweight VM boundary, not a guarantee against every kernel/host vulnerability. Keep the host OS patched and do not expose secrets, credentials, or user profile directories to the sandbox.
