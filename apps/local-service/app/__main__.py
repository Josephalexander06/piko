"""Run the development service on IPv4 loopback only."""

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8765,
        reload=False,
        access_log=False,
        proxy_headers=False,
    )
