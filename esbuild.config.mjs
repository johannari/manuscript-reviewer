import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

esbuild
	.build({
		entryPoints: ["main.ts"],
		bundle: true,
		external: ["obsidian"],
		format: "cjs",
		platform: "browser",
		target: "es2018",
		logLevel: "info",
		sourcemap: prod ? false : "inline",
		treeShaking: true,
		outfile: "main.js",
		minify: prod,
		define: {
			"process.env.NODE_ENV": prod ? '"production"' : '"development"',
		},
	})
	.catch(() => process.exit(1));
