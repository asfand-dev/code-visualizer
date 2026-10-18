# create-code-visualizer

Lets you run [code-visualizer](https://www.npmjs.com/package/code-visualizer) through `npm create`:

```bash
npm create code-visualizer
```

Pass a command and options after `--`:

```bash
npm create code-visualizer@latest -- report --file=src/libs/index.ts
npm create code-visualizer@latest -- report --directory=src/components/area-chart
```

This is the same as `npx code-visualizer …`. See the [main README](https://github.com/asfand-ionos/code-visualizer#readme) for everything the report can do.
