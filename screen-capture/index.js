var fs = require('fs'),
	express = require('express'),
	https = require('https'),
	serveStatic = require('serve-static');

var app = express();

app.use(serveStatic('./public'));

var server = https.createServer({
	key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('certificate.pem'),
    passphrase: 'webrtc'
}, app).listen(8080, function() {
	var host = server.address().address;
	var port = server.address().port;

	console.log('Server running at https://%s:%d', host, port);
});