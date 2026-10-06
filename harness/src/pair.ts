/** Ask the running daemon to print a fresh one-use browser pairing code. */
import { API, apiFetch } from "./api";

const response = await apiFetch(`${API}/api/pair/start`, { method: "POST" });
if (!response.ok) throw new Error(`Pairing renewal failed (${response.status}): ${await response.text()}`);
console.log("A fresh one-use pairing code is printed in the running daemon's output - its terminal, or `bun run service logs` when Roostr runs as a service.");
