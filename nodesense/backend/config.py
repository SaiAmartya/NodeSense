"""
NodeSense Backend Configuration
Loads settings from environment variables / .env file.
"""

import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    """Application settings loaded from environment."""

    # Gemini API
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
    GEMINI_MODEL: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    # Server
    BACKEND_HOST: str = os.getenv("BACKEND_HOST", "0.0.0.0")
    BACKEND_PORT: int = int(os.getenv("BACKEND_PORT", "8000"))

    # Graph parameters
    MAX_GRAPH_NODES: int = int(os.getenv("MAX_GRAPH_NODES", "500"))
    GRAPH_PERSIST_PATH: str = os.getenv("GRAPH_PERSIST_PATH", "graph.pkl")

    # Bayesian inference
    DECAY_RATE: float = float(os.getenv("DECAY_RATE", "0.01"))  # per hour
    LAPLACE_SMOOTHING: float = float(os.getenv("LAPLACE_SMOOTHING", "0.1"))

    # Community detection
    COMMUNITY_RESOLUTION: float = float(os.getenv("COMMUNITY_RESOLUTION", "1.0"))
    COMMUNITY_SEED: int = int(os.getenv("COMMUNITY_SEED", "42"))

    # Content processing
    MAX_CONTENT_LENGTH: int = int(os.getenv("MAX_CONTENT_LENGTH", "3000"))
    MAX_KEYWORDS_PER_PAGE: int = int(os.getenv("MAX_KEYWORDS_PER_PAGE", "5"))


settings = Settings()
