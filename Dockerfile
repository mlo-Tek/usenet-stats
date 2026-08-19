FROM python:3.13-alpine
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN mkdir -p /config
ENV PORT=8780
EXPOSE 8780
CMD ["gunicorn", "--bind", "0.0.0.0:8780", "--workers", "1", "--threads", "6", "--timeout", "120", "server:app"]