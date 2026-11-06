# Certificate fixtures

Everything here is test data for `test/cert.test.ts` and `test/certSecrets.test.ts`, written by `make.sh` (OpenSSL 3.4 or later, and ssh-keygen).

**The private keys in this folder are throwaway keys generated for these tests.** They protect nothing and were never used anywhere else; the passphrase of the encrypted ones is `previewix`. They are committed on purpose: the tests check that nothing of them shows up in what `parseCertFile()` returns. A secret scanner that reports them can be told to ignore this folder.

The names, serial numbers, dates and extensions are fixed in `make.sh` and repeated as constants in the tests, so run the tests after regenerating.
