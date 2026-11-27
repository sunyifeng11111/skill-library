import { startApp } from "./app";
import { desktop } from "./shared/desktop";
import "./styles/app.css";

void startApp(document.querySelector<HTMLElement>("#app")!, desktop);
