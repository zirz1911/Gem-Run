import http from "node:http";
import net from "node:net";
import {pathToFileURL} from "node:url";

const remoteHost = process.env.GEMLOGIN_CDP_REMOTE_HOST || "127.0.0.1";
const remotePort = Number(process.env.GEMLOGIN_CDP_REMOTE_PORT || 9222);
const remoteHeaderHost = process.env.GEMLOGIN_CDP_REMOTE_HEADER_HOST || remoteHost;
const bridgeHost = process.env.GEMLOGIN_CDP_BRIDGE_HOST || "127.0.0.1";
const bridgePort = Number(process.env.GEMLOGIN_CDP_BRIDGE_PORT || 9223);

export function makeUpstreamHeaders(headers, headerHost, port) {
  return {...headers, host: `${headerHost}:${port}`};
}

function upstreamHeaders(headers) {
  return makeUpstreamHeaders(headers, remoteHeaderHost, remotePort);
}

const server = http.createServer((request, response) => {
  const proxy = http.request({
    host: remoteHost, port: remotePort, path: request.url, method: request.method,
    headers: upstreamHeaders(request.headers)
  }, (upstream) => {
    response.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(response);
  });
  proxy.on("error", () => response.writeHead(502).end());
  request.pipe(proxy);
});

server.on("upgrade", (request, client) => {
  const upstream = net.connect(remotePort, remoteHost, () => {
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
    for (const [name, value] of Object.entries(upstreamHeaders(request.headers))) {
      upstream.write(`${name}: ${value}\r\n`);
    }
    upstream.write("\r\n");
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.on("error", () => client.destroy());
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(bridgePort, bridgeHost, () => {
    console.log(`GemLogin CDP bridge listening on ${bridgeHost}:${bridgePort}`);
  });
}
