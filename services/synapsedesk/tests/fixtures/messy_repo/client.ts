// Old frontend contract; inventoried, not treated as a Python AST fact.
export async function loadUsers() {
  return fetch('/v1/users').then(response => response.json());
}
