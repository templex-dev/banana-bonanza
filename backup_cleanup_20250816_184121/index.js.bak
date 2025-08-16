const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// health check for render
app.get("/healthz", (_req, res) => res.send("ok"));

// simple home page to prove it's running
app.get("/", (_req, res) => res.send("Banana Bonanza server is running 🍌"));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
