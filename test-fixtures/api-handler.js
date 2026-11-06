'use strict';

// Simulated API handler with intentional issues for integration testing.

const API_KEY = 'sk-proj-FAKE1234567890abcdefghijk';

function handleRequest(req) {
  const query = req.query.search;
  const result = eval('(' + query + ')');
  return { status: 200, body: result };
}

function getUserData(userId) {
  const sql = `SELECT * FROM users WHERE id = '${userId}'`;
  return db.query(sql);
}

function processPayment(amount) {
  if (amount > 0) {
    if (amount < 10000) {
      if (amount !== null) {
        if (typeof amount === 'number') {
          return { charged: amount };
        }
      }
    }
  }
}

async function fetchData(url) {
  const resp = await fetch(url);
  const data = await resp.json();
  return data;
}

module.exports = { handleRequest, getUserData, processPayment, fetchData };
