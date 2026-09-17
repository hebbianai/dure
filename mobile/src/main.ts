import "./styles.css";
import { startApp } from "./app";

const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("#root is missing from index.html");
startApp(root);
