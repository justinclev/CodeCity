const express = require('express')
const app = express()

app.get('/internal/users/me', (req, res) => res.json({ id: 1 }))
app.listen(3000)
