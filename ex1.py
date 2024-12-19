import cv2
import torch
import numpy as np
import torch.nn as nn

class ResidualBlock(nn.Module):
    def __init__(self, in_channels, out_channels, kernel_size=3, stride=1, padding=1):
        super(ResidualBlock, self).__init__()

        self.conv1 = nn.Conv2d(in_channels, out_channels, kernel_size, stride, padding)
        self.relu = nn.ReLU(inplace=True)
        self.conv2 = nn.Conv2d(out_channels, out_channels, kernel_size, stride, padding)

    def forward(self, x):
        residual = x
        x = self.relu(self.conv1(x))
        x = self.conv2(x)
        x += residual
        return x

class Generator(nn.Module):
    def __init__(self, num_blocks=4, base_channels=16):
        super(Generator, self).__init__()

        self.conv1 = nn.Conv2d(3, base_channels, kernel_size=3, stride=1, padding=1)
        self.relu = nn.ReLU(inplace=True)

        self.res_blocks = nn.Sequential(*[ResidualBlock(base_channels, base_channels) for _ in range(num_blocks)])

        self.conv2 = nn.Conv2d(base_channels, 3, kernel_size=3, stride=1, padding=1)

    def forward(self, x):
        x = self.relu(self.conv1(x))
        x = self.res_blocks(x)
        x = self.conv2(x)
        return x

def enhance_video(input_video_path, output_video_path, model_path, batch_size=8):
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

    model = Generator()
    checkpoint = torch.load(model_path, map_location=device)
    
    model.load_state_dict(checkpoint, strict=False)
    
    model = model.to(device)
    model.eval()

    cap = cv2.VideoCapture(input_video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    fourcc = cv2.VideoWriter_fourcc(*'XVID')
    out = cv2.VideoWriter(output_video_path, fourcc, fps, (frame_width, frame_height))

    frames = []
    frame_count = 0
    while cap.isOpened():
        ret, frame = cap.read()
        if ret:


            frames.append(frame)
            frame_count += 1

            if len(frames) == batch_size or not ret:
                for f in frames:
                    out.write(f)

                frames = []

            print(f"Processed frame: {frame_count}")

        else:
            break

    cap.release()
    out.release()
    cv2.destroyAllWindows()

input_video_path = 'opdemo.mp4'
output_video_path = 'out.avi'
model_path = 'realesr-animevideo.pth'
enhance_video(input_video_path, output_video_path, model_path)
