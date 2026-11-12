from os import environ

import jwt
from fastapi import Depends, HTTPException, Request


jwks = jwt.PyJWKClient(
    f'{environ["KEYCLOAK_URL"]}/realms/{environ["KEYCLOAK_REALM"]}/protocol/openid-connect/certs',
    timeout=3,
)


def claims(request: Request):
    auth = request.headers.get("Authorization")
    token = request.cookies.get("edemand_token") if auth is None else auth.removeprefix("Bearer ")
    if not token:
        raise HTTPException(401, "missing bearer token")
    try:
        key = jwks.get_signing_key_from_jwt(token)
        return jwt.decode(
            token, key.key, algorithms=["RS256"],
            issuer=environ["KEYCLOAK_ISSUER"], audience=environ["KEYCLOAK_AUDIENCE"],
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
    except jwt.PyJWTError:
        raise HTTPException(401, "invalid bearer token") from None


def require_worker(payload=Depends(claims)):
    if payload.get("azp") != "edemand-payments-worker":
        raise HTTPException(403, "service account required")


def user_id(role):
    def require_user(payload=Depends(claims)):
        if payload.get("role") != role:
            raise HTTPException(403, f"{role} role required")
        local_id = payload.get("local_id")
        if type(local_id) is int and 0 < local_id < 2**53:
            return local_id
        if isinstance(local_id, str) and local_id.isascii() and local_id.isdecimal() and len(local_id) <= 16:
            if 0 < int(local_id) < 2**53:
                return int(local_id)
        raise HTTPException(401, "invalid local user ID")
    return require_user
