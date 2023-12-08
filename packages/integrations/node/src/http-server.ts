import type { AstroUserConfig } from 'astro/config';
import https from 'https';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'path';
import send from 'send';
import enableDestroy from 'server-destroy';

interface CreateServerOptions {
	client: URL;
	port: number;
	host: string | undefined;
	removeBase: (pathname: string) => string;
	assets: string;
}

function parsePathname(pathname: string, host: string | undefined, port: number) {
	try {
		const urlPathname = new URL(pathname, `http://${host}:${port}`).pathname;
		return decodeURI(encodeURI(urlPathname));
	} catch (err) {
		return undefined;
	}
}

export function createServer(
	{ client, port, host, removeBase, assets }: CreateServerOptions,
	handler: http.RequestListener,
	trailingSlash: AstroUserConfig['trailingSlash']
) {
	// The `base` is removed before passed to this function, so we don't
	// need to check for it here.
	const assetsPrefix = `/${assets}/`;
	function isImmutableAsset(pathname: string) {
		return pathname.startsWith(assetsPrefix);
	}

	const listener: http.RequestListener = (req, res) => {
		if (req.url) {
			const [urlPath, urlQuery] = req.url.split('?');
			const filePath = path.join(fileURLToPath(client), removeBase(urlPath));

			let pathname: string;
			let isDirectory = false;
			try {
				isDirectory = fs.lstatSync(filePath).isDirectory();
			}
			catch (err) { }

			if (!trailingSlash) // should never happen
				trailingSlash = 'ignore';

			const hasSlash = urlPath.endsWith('/');
			switch (trailingSlash) {
				case "never":
					if (isDirectory && hasSlash) {
						pathname = urlPath.slice(0, -1) + (urlQuery ? "?" + urlQuery : "");
						res.statusCode = 301;
						res.setHeader('Location', pathname);
					} else pathname = urlPath;
					// intentionally fall through
				case "ignore":
					{
						if (isDirectory && !hasSlash) {
							pathname = urlPath + "/index.html";
						} else
							pathname = urlPath;
					}
					break;
				case "always":
					if (!hasSlash) {
						pathname = urlPath + '/' +(urlQuery ? "?" + urlQuery : "");
						res.statusCode = 301;
						res.setHeader('Location', pathname);
					} else
						pathname = urlPath;
				break;
			}
			pathname = removeBase(pathname);

			if (urlQuery && !pathname.includes('?')) {
				pathname = pathname + '?' + urlQuery;
			}
			const encodedURI = parsePathname(pathname, host, port);

			if (!encodedURI) {
				res.writeHead(400);
				res.end('Bad request.');
				return res;
			}

			const stream = send(req, encodedURI, {
				root: fileURLToPath(client),
				dotfiles: pathname.startsWith('/.well-known/') ? 'allow' : 'deny',
			});

			let forwardError = false;

			stream.on('error', (err) => {
				if (forwardError) {
					console.error(err.toString());
					res.writeHead(500);
					res.end('Internal server error');
					return;
				}
				// File not found, forward to the SSR handler
				handler(req, res);
			});
			stream.on('headers', (_res: http.ServerResponse<http.IncomingMessage>) => {
				if (isImmutableAsset(encodedURI)) {
					// Taken from https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control#immutable
					_res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
				}
			});
			stream.on('directory', () => {
				// On directory find, redirect to the trailing slash
				let location: string;
				if (req.url!.includes('?')) {
					const [url = '', search] = req.url!.split('?');
					location = `${url}/?${search}`;
				} else {
					location = req.url + '/';
				}

				res.statusCode = 301;
				res.setHeader('Location', location);
				res.end(location);
			});
			stream.on('file', () => {
				forwardError = true;
			});
			stream.pipe(res);
		} else {
			handler(req, res);
		}
	};

	let httpServer:
		| http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>
		| https.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;

	if (process.env.SERVER_CERT_PATH && process.env.SERVER_KEY_PATH) {
		httpServer = https.createServer(
			{
				key: fs.readFileSync(process.env.SERVER_KEY_PATH),
				cert: fs.readFileSync(process.env.SERVER_CERT_PATH),
			},
			listener
		);
	} else {
		httpServer = http.createServer(listener);
	}
	httpServer.listen(port, host);
	enableDestroy(httpServer);

	// Resolves once the server is closed
	const closed = new Promise<void>((resolve, reject) => {
		httpServer.addListener('close', resolve);
		httpServer.addListener('error', reject);
	});

	return {
		host,
		port,
		closed() {
			return closed;
		},
		server: httpServer,
		stop: async () => {
			await new Promise((resolve, reject) => {
				httpServer.destroy((err) => (err ? reject(err) : resolve(undefined)));
			});
		},
	};
}
