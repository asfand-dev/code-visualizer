# create-code-visualizer

Lets you run [code-visualizer](https://www.npmjs.com/package/code-visualizer) through `npm create`:

```bash
npm create code-visualizer
```

Pass a command and options after `--`:

```bash
npm create code-visualizer@latest -- serve                     # live companion next to your editor
npm create code-visualizer@latest -- report --file=src/libs/index.ts
npm create code-visualizer@latest -- impact src/lib/format.ts  # what a change affects
npm create code-visualizer@latest -- agents init               # set up Claude Code, Cursor & co.
npm create code-visualizer@latest -- check --changed           # fail only on new problems
```

This is the same as `npx code-visualizer …`. For daily use, install it (`npm i -D code-visualizer`) so git hooks, status lines and agent hooks start fast, and run `npx code-visualizer --help` for every command. See the [main README](https://github.com/asfand-ionos/code-visualizer#readme) for everything it can do.
