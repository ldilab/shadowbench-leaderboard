import { cp, mkdir, rm } from "node:fs/promises";

const files = ["index.html", "submit.html", "paper.html", ".nojekyll"];
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await Promise.all(files.map((path) => cp(path, `dist/${path}`)));
await Promise.all(["assets", "data"].map((path) => cp(path, `dist/${path}`, { recursive: true })));
console.log("Built static site in dist/");
