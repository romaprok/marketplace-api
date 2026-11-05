// demo:upload's uploader: a separate process whose environment holds nothing
// but PATH. It has a presigned URL and bytes on stdin; no storage keys, no API.
const [url, contentType] = process.argv.slice(2);

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

const res = await fetch(url!, { method: 'PUT', headers: { 'content-type': contentType! }, body: Buffer.concat(chunks) });
const secretsInEnv = Object.keys(process.env).filter((k) => /KEY|SECRET|TOKEN|PASSWORD|PEPPER|_URL$/.test(k)).length;
console.log(JSON.stringify({ status: res.status, secretsInEnv }));
