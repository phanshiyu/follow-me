declare module "prismjs/components/prism-core" {
  const Prism: typeof import("prismjs");
  export default Prism;
}
// Every other component only extends the global Prism; nothing is imported from it.
declare module "prismjs/components/*";
