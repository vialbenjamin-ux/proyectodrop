const https = require('https');

exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS'){
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      },
      body: ''
    };
  }

  const params = event.queryStringParameters || {};
  const targetUrl = params.url;
  const token = params.token || event.headers.authorization || event.headers.Authorization;

  // ── MODO PROXY GMAIL ──────────────────────────────────────────────────────
  if(targetUrl){
    if(!token) return { statusCode:400, headers:{'Access-Control-Allow-Origin':'*'}, body:'Missing token' };
    const authHeader = token.startsWith('Bearer ') ? token : 'Bearer '+token;
    return makeRequest(targetUrl, 'GET', {'Authorization': authHeader, 'Accept': 'application/json'}, null);
  }

  // ── MODO PROXY CLAUDE ─────────────────────────────────────────────────────
  if(event.httpMethod === 'POST' && event.body){
    return makeRequest(
      'https://api.anthropic.com/v1/messages',
      'POST',
      { 'Content-Type': 'application/json' },
      event.body
    );
  }

  return { statusCode:400, headers:{'Access-Control-Allow-Origin':'*'}, body:'Missing params' };
};

function makeRequest(url, method, headers, body){
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: method,
      headers: headers
    };
    if(body) options.headers['Content-Length'] = Buffer.byteLength(body);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: data
        });
      });
    });
    req.on('error', (e) => {
      resolve({ statusCode:500, headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify({error:e.message}) });
    });
    if(body) req.write(body);
    req.end();
  });
}
