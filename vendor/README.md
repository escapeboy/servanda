# vendor/vectors

The conformance oracle, vendored from
[escapeboy/servanda-protocol](https://github.com/escapeboy/servanda-protocol) so CI can run the
suite without a second checkout. The upstream commit is pinned in `vectors/.SOURCE_COMMIT`.

**These files are generated upstream and are read-only here.** Never edit them to make a test
pass — the vectors define what "implements Servanda" means (GOVERNANCE.md). If a vector looks
wrong, that is a protocol issue to file, not a file to change.

To run the suite against a working copy of the protocol repo instead:

```bash
SERVANDA_VECTORS=../servanda-protocol/vectors pnpm gate:g0
```

To resync after upstream regenerates them:

```bash
bash gates/sync-vectors.sh ../servanda-protocol
```
