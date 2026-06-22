#!/bin/bash
# Start Xvfb virtual display
Xvfb :99 -screen 0 1920x1080x24 &
sleep 1

# Start XFCE desktop session
startxfce4 &
sleep 2

# Start screen recording if RECORD_VIDEO is set
if [ "$RECORD_VIDEO" = "1" ]; then
    ffmpeg -y -f x11grab -video_size 1920x1080 -i :99 -codec:v libx264 -preset ultrafast /output/recording.mp4 &
fi

# Execute the provided command or fall back to bash
if [ $# -gt 0 ]; then
    exec "$@"
else
    exec /bin/bash
fi
