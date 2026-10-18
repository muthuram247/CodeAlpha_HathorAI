# Hathor model artifact

After you train `HathorAI_Colab_Training.ipynb`, download `hathor_lstm_weights.npz` and upload it into this folder with the exact name:

`model/hathor_lstm_weights.npz`

Render will load this file at startup/request time. It contains the weights of the custom LSTM trained in your Colab session, genre metadata, and small MIDI-roll seed contexts. It does not contain a pretrained music-generation model.

The model artifact is intentionally not included in the starter ZIP because it must be produced by running the training notebook on your own dataset. Until you add it, `/api/model-info` will report that the custom model is not installed.
