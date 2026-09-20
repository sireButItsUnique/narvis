# Deliberately contradictory service

Old client docs: `GET /v1/users` returns accounts. The code now registers `GET /v2/users`.
The order API claims `POST /orders` still exists, but the implementation was removed.

This example is inspected as text; its intentionally missing framework is never imported.
