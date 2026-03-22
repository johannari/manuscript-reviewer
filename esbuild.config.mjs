import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";

const prod = process.argv[2] === "production";

// Plugin to inline the pdf.js worker as a text string
const inlineWorkerPlugin = {
	name: "inline-worker",
	setup(build) {
		build.onResolve({ filter: /pdf\.worker\.min\.mjs$/ }, (args) => {
			return {
				path: path.resolve(
					"node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"
				),
				namespace: "inline-worker",
			};
		});
		build.onLoad(
			{ filter: /.*/, namespace: "inline-worker" },
			(args) => {
				const contents = fs.readFileSync(args.path, "utf8");
				return {
					contents: `export default ${JSON.stringify(contents)};`,
					loader: "js",
				};
			}
		);
	},
};

esbuild
	.build({
		entryPoints: ["main.ts"],
		bundle: true,
		external: ["obsidian", "child_process", "util"],
		format: "cjs",
		platform: "browser",
		target: "es2018",
		logLevel: "info",
		sourcemap: prod ? false : "inline",
		treeShaking: true,
		outfile: "main.js",
		minify: prod,
		plugins: [inlineWorkerPlugin],
		define: {
			"process.env.NODE_ENV": prod ? '"production"' : '"development"',
		},
	})
	.catch(() => process.exit(1));
