import numpy as np
import librosa
import tensorflow as tf
from tensorflow.keras import layers, models

def load_audio(file_path, sr=16000):
    y, _ = librosa.load(file_path, sr=sr)
    return y

def add_noise(audio, noise_factor=0.1):
    noise = np.random.randn(len(audio))
    augmented_audio = audio + noise_factor * noise
    return augmented_audio

def create_dataset(original_files, noise_factor=0.1):
    X = []
    y = []
    for file in original_files:
        original_audio = load_audio(file)
        noisy_audio = add_noise(original_audio, noise_factor=noise_factor)
        X.append(noisy_audio)
        y.append(original_audio)
    return np.array(X), np.array(y)

def build_model(input_shape):
    model = models.Sequential([
        layers.Dense(256, activation='relu', input_shape=input_shape),
        layers.Dense(128, activation='relu'),
        layers.Dense(64, activation='relu'),
        layers.Dense(128, activation='relu'),
        layers.Dense(256, activation='relu'),
        layers.Dense(input_shape[0], activation='sigmoid')
    ])
    model.compile(optimizer='adam', loss='mse')
    return model

original_files = ['original_1.wav', 'original_2.wav', ...] 

X_train, y_train = create_dataset(original_files)

X_train = np.reshape(X_train, (X_train.shape[0], X_train.shape[1], 1))
y_train = np.reshape(y_train, (y_train.shape[0], y_train.shape[1], 1))

model = build_model(input_shape=(X_train.shape[1], 1))

model.fit(X_train, y_train, batch_size=32, epochs=10, validation_split=0.2)
