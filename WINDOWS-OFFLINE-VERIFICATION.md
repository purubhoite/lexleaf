# Windows offline verification procedure

This procedure is intended for the dedicated Windows CI/manual verification workflow. It must not be described as passed until it has actually run on Windows.

1. Build and verify the unpacked application and NSIS installer using `.github/workflows/windows-release-verify.yml`.
2. Install the installer silently into a disposable runner directory.
3. Launch the installed Lexleaf executable.
4. Open a representative synthetic PDF fixture copied to the disposable runner workspace.
5. Double-click a known dictionary word such as `watched`.
6. Confirm the contextual popup displays the expected OEWN-derived definition and multiple senses.
7. Use Save word, open Saved words and confirm the word is present.
8. Close and relaunch Lexleaf; confirm the saved vocabulary remains present in the isolated application data directory.
9. Disable networking on the runner or apply a Windows firewall rule blocking outbound access for the test process.
10. Open the PDF again and repeat dictionary lookup.
11. Confirm lookup succeeds while networking is disabled.
12. Record the installer SHA-256, Windows version, Electron version, dictionary manifest hash and test result.

The test must use an isolated user-data directory and synthetic fixtures. It must not access real user documents or databases. A failure to launch, missing dictionary, missing notice or lookup failure is a release-blocking result.
