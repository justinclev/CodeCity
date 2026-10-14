export const orders = () => fetch('http://gateway:8000/api/shop/orders').then(r => r.json())
export const profile = () => fetch('http://gateway:8000/api/shop/profile').then(r => r.json())
