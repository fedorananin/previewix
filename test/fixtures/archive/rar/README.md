These four archives come from the test files of the Python package `rarfile`
(https://github.com/markokr/rarfile, `test/files/`, ISC licence, Copyright (c) 2005-2024 Marko Kreen).
Nothing on the machines this project is built on can write a RAR archive.

- `rar5-solid.rar`, `rar3-solid.rar`: `stest1.txt` and `stest2.txt`, each the lines `000` to `511`, packed solid.
- `rar5-psw.rar`: the same two files, encrypted with the password `password`.
- `rar5-symlink-unix.rar`: `data.txt` and two symbolic links, one of them pointing outside (`../random123`).
