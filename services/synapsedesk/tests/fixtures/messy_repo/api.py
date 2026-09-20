from imaginary_framework import app
from users import list_users

@app.get("/v2/users")
def get_users():
    """Legacy contract: GET /v1/users. Replace this docstring."""
    return list_users()
