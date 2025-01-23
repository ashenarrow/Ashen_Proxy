const http = require("http");
const fetch = require("node-fetch");
const querystring = require("querystring");
const fs = require("fs");
const path = require("path");

http
  .createServer(async (req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        const parsedBody = querystring.parse(body);
        const targetUrl = parsedBody.url;

        if (!targetUrl) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Error: No URL provided.");
          return;
        }

        try {
          const response = await fetch(targetUrl);

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          const html = await response.text();

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(html);
        } catch (error) {
          console.error("Fetch error:", error);
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Error fetching URL: " + error);
        }
      });
    } else if (req.method === "GET" && req.url !== "/") {
      const queryParams = new URLSearchParams(req.url.slice(1));
      const clickedUrl = queryParams.get("url");

      if (!clickedUrl) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Error: No URL provided in query string.");
        return;
      }

      try {
        const response = await fetch(clickedUrl);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const html = await response.text();

        res.writeHead(200, {
          "Content-Type": "text/html",
          "Cache-Control": "no-cache",
        });
        res.end(html);
      } catch (error) {
        console.error("Fetch error:", error);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error fetching URL: " + error);
      }
    } else if (req.url === "/") {
      const filePath = path.join(__dirname, "index.html");
      fs.readFile(filePath, (err, content) => {
        if (err) {
          console.error("Error reading index.html:", err);
          res.writeHead(500);
          res.end("Error reading index.html");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(content);
      });
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
    }
  })
  .listen(8080);

console.log("Server listening on port 8080");
