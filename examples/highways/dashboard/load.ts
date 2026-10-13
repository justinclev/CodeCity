export const report = () => fetch(`${process.env.REPORTS_URL}/api/reports`).then(r => r.json())

export const products = () =>
  fetch(`${process.env.GRAPHQL_URL}/graphql`, {
    method: 'POST',
    body: JSON.stringify({ query: 'query { products { id name } }' }),
  })

export const ticker = () => new WebSocket('ws://notifications:8081/ws')
