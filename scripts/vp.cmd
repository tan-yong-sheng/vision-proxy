@echo off
rem Launcher for the vision-proxy CLI shipped in the release tarball.
rem Runs the compiled ES-module entry point (dist/cli.js) under the system node.
set "here=%~dp0"
node "%here%dist\cli.js" %*
