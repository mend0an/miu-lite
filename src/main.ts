// Entry point of the widget window.

import "./widget/widget.css";
import { Widget } from "./widget/widget";

const root = document.getElementById("root");
if (root) void new Widget(root).start();
