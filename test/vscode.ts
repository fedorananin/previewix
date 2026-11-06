// Stands in for the `vscode` module when a test loads a file that imports it (see run.js). It is empty on
// purpose: the tests cover what runs without VS Code, and a provider that reaches for the API should fail.
export {};
